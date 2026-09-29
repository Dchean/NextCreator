# Validate evidence paths against the r2 packet (adapted from validate-review-evidence.py)
import json, os, sys
root = os.path.abspath(".")
candidate_paths = set()
packet = os.path.join(root, ".workflow-kit/tasks/evidence/review-packet-TASK-007-r2.json")
with open(packet, encoding="utf-8") as handle:
    for item in json.load(handle)["task_packet"]["candidate_files"]:
        candidate_paths.add(item["path"])
report_path = sys.argv[1]
with open(report_path, encoding="utf-8") as handle:
    report = json.load(handle)
problems = []
seen = set()
for check in report["review_checks"]:
    files = check.get("evidence_files")
    if not isinstance(files, list) or (check["status"] == "PASS" and not files):
        problems.append("%s: missing evidence_files" % check["area"])
        continue
    for name in files:
        if name in seen:
            continue
        seen.add(name)
        full = os.path.join(root, name.replace("/", os.sep))
        if name in candidate_paths:
            kind = "candidate"
        elif name.startswith(".workflow-kit/tasks/evidence/") or name.startswith(".workflow-kit/tasks/runs/"):
            kind = "attachment"
        else:
            problems.append("%s: NOT a candidate file or tasks/evidence|runs attachment: %s" % (check["area"], name))
            continue
        if not os.path.isfile(full):
            problems.append("%s: MISSING (%s): %s" % (check["area"], kind, name))
        elif os.path.getsize(full) == 0:
            problems.append("%s: EMPTY (0 bytes, %s): %s" % (check["area"], kind, name))
print("report:", report_path)
print("verdict:", report["verdict"], "findings:", len(report["findings"]))
print("distinct evidence files:", len(seen))
if problems:
    print("PROBLEMS (%d):" % len(problems))
    for item in problems:
        print("  -", item)
    sys.exit(1)
print("OK: every evidence path exists, is nonempty, and is allowed")
