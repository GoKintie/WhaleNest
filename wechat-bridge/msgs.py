import re

CQ_RE = re.compile(r"\[CQ:([^,\]]+)((?:,[^\]]*)?)\]")


def unescape(s: str) -> str:
    return (s.replace("&#91;", "[").replace("&#93;", "]")
             .replace("&#44;", ",").replace("&amp;", "&"))


def escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("[", "&#91;")
             .replace("]", "&#93;").replace(",", "&#44;"))


def _seg(t, **data):
    return {"type": t, "data": data}


def cq_to_segments(raw: str):
    out, pos = [], 0
    for m in CQ_RE.finditer(raw):
        if m.start() > pos:
            txt = unescape(raw[pos:m.start()])
            if txt:
                out.append(_seg("text", text=txt))
        ctype = m.group(1)
        data = {}
        body = m.group(2) or ""
        for pair in body.split(","):
            if not pair:
                continue
            if "=" in pair:
                k, v = pair.split("=", 1)
                data[k.strip()] = unescape(v)
            else:
                data[pair.strip()] = ""
        out.append(_seg(ctype, **data))
        pos = m.end()
    if pos < len(raw):
        txt = unescape(raw[pos:])
        if txt:
            out.append(_seg("text", text=txt))
    return out


def segments_to_cq(segs) -> str:
    parts = []
    for s in segs:
        t = s.get("type", "text")
        d = s.get("data") or {}
        if t == "text":
            parts.append(escape(str(d.get("text", ""))))
        else:
            kv = ",".join(f"{k}={escape(str(v))}" for k, v in d.items())
            parts.append(f"[CQ:{t}{',' + kv if kv else ''}]")
    return "".join(parts)


def normalize(message) -> list:
    if isinstance(message, str):
        return cq_to_segments(message)
    if isinstance(message, list):
        out = []
        for s in message:
            if not isinstance(s, dict):
                continue
            out.append(_seg(str(s.get("type", "text")), **(s.get("data") or {})))
        return out
    return []


def to_text(segs) -> str:
    buf = []
    for s in segs:
        t = s.get("type")
        d = s.get("data") or {}
        if t == "text":
            buf.append(str(d.get("text", "")))
        elif t == "at":
            qq = str(d.get("qq", ""))
            buf.append("@所有人" if qq == "all" else f"@{qq}")
        elif t == "image":
            buf.append("[图片]")
        elif t == "face":
            buf.append("[表情]")
        elif t == "record":
            buf.append("[语音]")
        else:
            buf.append(f"[{t}]")
    return "".join(buf)
