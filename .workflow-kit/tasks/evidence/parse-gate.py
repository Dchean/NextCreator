import io, re, os, sys

def read_any(path):
    raw = open(path, "rb").read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-16", errors="replace")

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("TEMP", "."), "req001-before.txt")
s = read_any(path)
blocks = re.split(r"(?=【\d+】用例)", s)
rows = []
for b in blocks:
    if not b.startswith("【"):
        continue
    title = b.split("\n")[0].strip()
    m = re.search(r"判定：(PASS|FAIL)", b)
    rows.append((m.group(1) if m else "?", title))

out = []
for verdict, title in rows:
    out.append("%-5s %s" % (verdict, title))
out.append("")
out.append("TOTAL PASS=%d FAIL=%d" % (sum(1 for v, _ in rows if v == "PASS"),
                                      sum(1 for v, _ in rows if v == "FAIL")))
io.open(os.path.join(os.environ["TEMP"], "gate-summary.txt"), "w", encoding="utf-8").write("\n".join(out))
print("\n".join(out).encode("utf-8", "replace").decode("utf-8", "replace"))
