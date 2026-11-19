"""NAS native WeChat voice integration. GPL-3.0-or-later; see UPSTREAM.md."""
import os
import json
import math
import struct
import time
import hashlib
import tempfile
import subprocess
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from threading import Lock, Timer

HERE = Path(__file__).resolve().parent
from .voice_audio import PulseVoiceSource, prepare_voice


def runtime_env():
    p = HERE / 'audio-root' / 'usr'
    return dict(os.environ, HOME='/config',
                PULSE_SERVER='unix:/tmp/run/user/app/pulse/native',
                PATH=str(p / 'bin') + ':' + os.environ.get('PATH', ''),
                LD_LIBRARY_PATH=':'.join(str(p / part) for part in [
                    'lib/pulse-15.99.1+dfsg1/modules',
                    'lib/x86_64-linux-gnu/pulseaudio', 'lib/x86_64-linux-gnu']))


def match_template(pixels, width, height, template, tw, th):
    # Match the small grayscale control by normalized correlation. Sampling
    # alternate pixels bounds runtime on the NAS without a CV dependency.
    samples = [(x, y, template[y * tw + x]) for y in range(0, th, 2) for x in range(0, tw, 2)]
    n = len(samples)
    ts = sum(v for _, _, v in samples)
    tv = n * sum(v * v for _, _, v in samples) - ts * ts
    offsets = [(y * width + x, v) for x, y, v in samples]
    best, point = 0, None
    for y in range(height - th + 1):
        for x in range(width - tw + 1):
            i = y * width + x
            ps = pq = pt = 0
            for delta, t in offsets:
                p = pixels[i + delta]
                ps += p
                pq += p * p
                pt += p * t
            pv = n * pq - ps * ps
            if pv <= 0 or tv <= 0:
                continue
            score = (n * pt - ps * ts) / math.sqrt(pv * tv)
            if score > best:
                best, point = score, (x, y)
    return best, point


def locate(driver, win, *names):
    env = dict(os.environ, DISPLAY=driver.display)
    active = subprocess.check_output(['xdotool', 'getactivewindow'], env=env, timeout=5).decode().strip()
    if active != str(win):
        raise RuntimeError('WeChat target window is not active')
    raw = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', str(win)], env=env, timeout=5).decode()
    geo = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    x, y, w, h = [int(geo[k]) for k in ['X', 'Y', 'WIDTH', 'HEIGHT']]
    if w < 600 or h < 400:
        raise RuntimeError('WeChat voice window is too small')
    x, y = x + w - 320, y + h - 70
    pixels = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'x11grab',
        '-framerate', '5', '-draw_mouse', '0', '-probesize', '32', '-analyzeduration', '0',
        '-video_size', '320x70', '-i', driver.display + '+' + str(x) + ',' + str(y),
        '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
        capture_output=True, timeout=8, check=True).stdout
    if len(pixels) != 320 * 70:
        raise RuntimeError('WeChat voice controls cannot be inspected')
    points = []
    for name in names:
        asset = HERE / 'assets' / ('voice_' + name + '.png')
        tw, th = struct.unpack('>II', asset.read_bytes()[16:24])
        template = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(asset),
            '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
            capture_output=True, timeout=5, check=True).stdout
        score, pos = match_template(pixels, 320, 70, template, tw, th)
        if score < .92:
            raise RuntimeError('WeChat voice ' + name + ' button not recognized; nothing sent')
        points.append((x + pos[0] + tw // 2, y + pos[1] + th // 2))
    return points


def verify_voice(driver, uname, before, seconds, timeout=15):
    table = 'Msg_' + hashlib.md5(str(uname).encode()).hexdigest()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        con = driver._connect('message_0.db')
        try:
            sid = con.execute('SELECT rowid FROM Name2Id WHERE user_name=?', (driver.self_wxid,)).fetchone()
            rows = con.execute('SELECT local_id,server_id,message_content FROM ' + table +
                ' WHERE local_id>? AND real_sender_id=? AND (local_type&65535)=34',
                (before, sid[0] if sid else -1)).fetchall()
        finally:
            con.close()
        matches = []
        for mid, server, content in rows:
            try:
                voice = ET.fromstring(driver._decode(content)).find('.//voicemsg')
                duration = int(voice.get('voicelength', '0')) / 1000 if voice is not None else 0
                if server and duration > 0 and abs(duration - seconds) <= 2:
                    matches.append(mid)
            except (ET.ParseError, ValueError):
                continue
        if len(matches) == 1:
            return True
        if len(matches) > 1:
            return False
        time.sleep(.4)
    return False


def send_file(driver, uname, target, file_path):
    """Called inside the bridge's send lock. Cancel errors before reporting failure."""
    with tempfile.TemporaryDirectory(prefix='whale-voice-') as temp:
        wav, meta = prepare_voice(temp, file_path=file_path)
        wanted = set(driver._cands(uname, target))
        if any(wanted.intersection(driver._cands(other, driver._display(other)))
               for other in set(driver._names) | set(driver._aliases) if other != uname):
            raise ValueError('WeChat voice destination has an ambiguous window title')
        win = driver._target_window(uname, target)
        table = 'Msg_' + hashlib.md5(str(uname).encode()).hexdigest()
        con = driver._connect('message_0.db')
        try:
            before = int(con.execute('SELECT max(local_id) FROM ' + table).fetchone()[0] or 0)
        finally:
            con.close()
        audio = PulseVoiceSource()
        audio.env = runtime_env()
        recording, cancel, timer, expired = False, None, None, False
        guard = Lock()
        def click(point):
            driver._xdo('mousemove', str(point[0]), str(point[1]), 'click', '1')
        def abort():
            nonlocal recording, expired
            with guard:
                expired = True
                if recording and cancel:
                    click(cancel)
                    recording = False
        clicked_send = False
        try:
            with audio:
                try:
                    start, = locate(driver, win, 'start')
                    click(start)
                    recording = True
                    started = time.monotonic()
                    time.sleep(.25)
                    cancel, send = locate(driver, win, 'cancel', 'send')
                    timer = Timer(max(.1, 57 - (time.monotonic() - started)), abort)
                    timer.daemon = True
                    timer.start()
                    audio.bind_recording()
                    if time.monotonic() - started + meta['duration_seconds'] > 55:
                        raise RuntimeError('Audio does not fit the recording time limit')
                    audio.play(wav, meta['duration_seconds'])
                    time.sleep(.15)
                    cancel, send = locate(driver, win, 'cancel', 'send')
                    with guard:
                        if expired:
                            raise RuntimeError('Recording deadline exceeded')
                        seconds = time.monotonic() - started
                        clicked_send = True
                        click(send)
                        recording = False
                finally:
                    if timer:
                        timer.cancel()
                    with guard:
                        if recording:
                            try:
                                if cancel is None:
                                    cancel, = locate(driver, win, 'cancel')
                                click(cancel)
                            except Exception:
                                driver._xdo('key', 'Escape')
                            recording = False
            return verify_voice(driver, uname, before, seconds)
        except Exception as exc:
            if clicked_send:
                raise RuntimeError("Voice send result unknown; check WeChat before retrying") from exc
            raise


def send_url(driver, uname, target, url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('dsh-onebot', 'localhost', '127.0.0.1') or parsed.path != '/api/raw':
        raise ValueError('Voice URL must be a signed agent artifact URL')
    with urllib.request.urlopen(url, timeout=20) as response:
        data = response.read(10 * 1024 * 1024 + 1)
    if not data or len(data) > 10 * 1024 * 1024:
        raise ValueError('Voice audio must be nonempty and at most 10 MiB')
    with tempfile.TemporaryDirectory(prefix='whale-voice-download-') as temp:
        p = Path(temp) / 'input.audio'
        p.write_bytes(data)
        return send_file(driver, uname, target, p)
