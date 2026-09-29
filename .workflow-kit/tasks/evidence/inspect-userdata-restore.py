"""Read-only inspection of NextCreator app-data.json vs the post-test copy.

Purpose: independently confirm, after the 2026-09-29 CDP manual verification, that
the user's real data was restored (test canvases / queue records removed) and that
no second (test) provider remains. Prints structure only; API keys are redacted.
"""
import json
import sys


def unwrap(value, *keys):
    """Peel the zustand-persist {state:{...}} and optional extra key layers."""
    seen = 0
    while seen < 6:
        seen += 1
        if isinstance(value, str):
            value = json.loads(value)
            continue
        if isinstance(value, dict):
            if "state" in value and isinstance(value["state"], (dict, str)):
                value = value["state"]
                continue
            for key in keys:
                if key in value:
                    value = value[key]
                    break
            else:
                return value
            continue
        return value
    return value


def summarise(path):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    settings = unwrap(data.get("next-creator-settings"), "settings")
    canvases = unwrap(data.get("next-creator-canvases"), "canvases")
    jobs = unwrap(data.get("generation-queue"), "jobs")
    providers = [
        (item.get("name"), "key" if item.get("apiKey") else "no-key")
        for item in (settings.get("providers") or [])
    ]
    canvas_list = [
        (item.get("name"), len(item.get("nodes") or [])) for item in (canvases or [])
    ]
    return {
        "providers": providers,
        "canvases": canvas_list,
        "queue_jobs": len(jobs or []),
        "top_level_keys": sorted(data.keys()),
    }


for target in sys.argv[1:]:
    print("==", target.rsplit("\\", 1)[-1])
    for key, value in summarise(target).items():
        print("   %-16s %s" % (key, value))
