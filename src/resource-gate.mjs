import fs from "node:fs";
import os from "node:os";
const GiB = 1024 ** 3;
let previousCpu;
// Linux /proc/meminfo is a fixed kernel interface; MemAvailable includes reclaimable cache.
export function sampleResources() {
  const at = Date.now();
  let available = os.freemem();
  if (process.platform === "linux") {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (!match) throw new Error("MemAvailable을 읽을 수 없습니다.");
    available = Number(match[1]) * 1024;
  }
  const cpu = os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  // Parallel stage gates may sample a few milliseconds apart; one kernel tick is
  // not a useful host utilisation window. Memory is still read on every call.
  if (!previousCpu) previousCpu = { ...cpu, at, percent: null };
  else if (at - previousCpu.at >= 250) {
    const delta = cpu.total - previousCpu.total;
    previousCpu = { ...cpu, at, percent: delta > 0 ? 100 * (1 - (cpu.idle - previousCpu.idle) / delta) : previousCpu.percent };
  }
  return { at, availableGiB: available / GiB, cpuPercent: previousCpu.percent, load: os.loadavg()[0], logicalCpus: os.cpus().length };
}
export function hasCapacity(sample, policy) {
  return Number.isFinite(sample.availableGiB) && sample.availableGiB >= policy.reserveGiB
    && Number.isFinite(sample.cpuPercent) && sample.cpuPercent <= policy.maxCpuPercent;
}
