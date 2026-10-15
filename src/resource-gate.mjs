import fs from "node:fs";
import os from "node:os";
const GiB = 1024 ** 3;
let previousCpu;
// Linux /proc/meminfo is a fixed kernel interface; MemAvailable includes reclaimable cache.
export function sampleResources() {
  let available = os.freemem();
  if (process.platform === "linux") {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (!match) throw new Error("MemAvailable을 읽을 수 없습니다.");
    available = Number(match[1]) * 1024;
  }
  const cpu = os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  const delta = previousCpu && cpu.total - previousCpu.total;
  const cpuPercent = delta > 0 ? 100 * (1 - (cpu.idle - previousCpu.idle) / delta) : null;
  previousCpu = cpu;
  return { at: Date.now(), availableGiB: available / GiB, cpuPercent, load: os.loadavg()[0], logicalCpus: os.cpus().length };
}
export function hasCapacity(sample, policy) {
  return Number.isFinite(sample.availableGiB) && sample.availableGiB >= policy.reserveGiB
    && Number.isFinite(sample.cpuPercent) && sample.cpuPercent <= policy.maxCpuPercent;
}
