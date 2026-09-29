/** Extract verdict + findings from the reviewer's report (tolerating its JSON quoting bug). */
import { readFileSync, writeFileSync } from "node:fs";

const P = ".workflow-kit/tasks/evidence/review-TASK-007-r1.json";
let t = readFileSync(P, "utf8");

const vm = t.match(/"verdict":\s*"(\w+)"/);
console.log("verdict:", vm && vm[1]);
const cm = t.match(/"candidate_digest":\s*"([a-f0-9]{16})/);
console.log("candidate:", cm && cm[1]);
const fm = t.match(/"verification_run":\s*"([^"]+)"/);
console.log("verification_run:", fm && fm[1]);

const fi = t.indexOf('"findings"');
const rc = t.indexOf('"review_checks"');
const findingsRaw = t.slice(fi, rc);
console.log("\n--- FINDINGS (raw) ---");
console.log(findingsRaw.slice(0, 5000));

// statuses
const statuses = [...t.matchAll(/"area":\s*"(\w+)",\s*"status":\s*"(\w+)"/g)].map((m) => `${m[1]}=${m[2]}`);
console.log("\nchecks:", statuses.join(" "));

// Attempt a repair: double-quote issues come from raw " inside string values around
// patterns like invoke("..._provider_secret"). Record the exact broken spots.
const badSpots = [...t.matchAll(/invoke\("[^"]*"\)/g)].map((m) => m[0]);
console.log("\nunescaped-quote suspects:", badSpots.slice(0, 10));
