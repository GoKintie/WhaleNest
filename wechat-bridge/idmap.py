import json
import os
import threading


class IdMap:
    """外部 ID(微信 wxid / 群 id) 与 OneBot 数字 ID 的双向持久映射。"""

    def __init__(self, path: str = "idmap.json", start: int = 100000):
        self.path = path
        self.lock = threading.Lock()
        self.data = {"next": start, "ext2int": {}, "int2ext": {}}
        if path and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                self.data.update(loaded)
            except Exception:
                pass

    def _save(self):
        if not self.path:
            return
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def to_int(self, kind: str, ext: str):
        if ext is None or ext == "":
            return None
        ext = str(ext)
        with self.lock:
            if ext.isdigit():
                return int(ext)
            key = f"{kind}:{ext}"
            if key in self.data["ext2int"]:
                return self.data["ext2int"][key]
            n = int(self.data["next"])
            self.data["next"] = n + 1
            self.data["ext2int"][key] = n
            self.data["int2ext"][str(n)] = ext
            self._save()
            return n

    def to_ext(self, i):
        if i is None:
            return None
        return self.data["int2ext"].get(str(i))
