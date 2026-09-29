"""Read-only view of the NextCreator settings store (api keys redacted).

Prints provider names / base URLs / model lists so the acceptance run can pick a
provider that cannot incur external cost.
"""
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)

settings = data.get("next-creator-settings")
while isinstance(settings, dict) and "state" in settings:
    settings = settings["state"]
if isinstance(settings, str):
    settings = json.loads(settings)

providers = (settings or {}).get("providers") or []
for index, item in enumerate(providers):
    key = item.get("apiKey") or ""
    print("provider[%d]" % index)
    for field in ("id", "name", "baseUrl", "baseURL", "apiBase", "protocol"):
        if field in item:
            print("   %-10s %s" % (field, item[field]))
    print("   %-10s %s" % ("apiKey", "<set len=%d prefix=%s>" % (len(key), key[:6]) if key else "<none>"))
    models = item.get("models") or item.get("modelList")
    if models:
        print("   %-10s %s" % ("models", json.dumps(models, ensure_ascii=False)[:300]))
    print("   %-10s %s" % ("otherKeys", sorted(k for k in item if k not in
          {"id", "name", "baseUrl", "baseURL", "apiBase", "protocol", "apiKey", "models", "modelList"})))
print()
print("all provider key fields:", sorted({k for item in providers for k in item}))
