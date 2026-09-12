import fs from 'node:fs';
const output = process.env.HARNESS_JOB_OUTPUT;
const total = Number(process.env.HARNESS_JOB_TOTAL);
let completed = process.env.HARNESS_JOB_RESUME
  ? JSON.parse(fs.readFileSync(process.env.HARNESS_JOB_RESUME, 'utf8')).completed : 0;
for (; completed < total;) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  completed++;
  const checkpoint = { version: 1, protocol: 'json-step@1', identity: process.env.HARNESS_JOB_IDENTITY,
    completed, total, payload: { count: completed } };
  fs.writeFileSync(`${output}/pending.json`, JSON.stringify(checkpoint));
  fs.renameSync(`${output}/pending.json`, `${output}/checkpoint.json`);
}
fs.writeFileSync(`${output}/result.json`, JSON.stringify({ count: completed }) + '\n');
console.log(`Counted ${completed} steps.`);
