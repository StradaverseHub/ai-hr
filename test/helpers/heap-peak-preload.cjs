// Test-only preload for the System Labels browser journey's `next dev` processes (passed through NODE_OPTIONS).
// It records each process's peak V8 used heap and peak resident memory into AIHR_HEAP_PEAK_DIR/heap-<pid>.json, so a
// run's evidence shows how close the dev server came to Next's restart threshold (used heap above 80% of its limit).
// No effect without AIHR_HEAP_PEAK_DIR. Never loaded by the application itself.
'use strict';
const dir = process.env.AIHR_HEAP_PEAK_DIR;
if (dir) {
  const v8 = require('node:v8');
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(dir, `heap-${process.pid}.json`);
  let peakUsedHeap = 0, peakRss = 0, heapLimit = 0;
  const sample = () => {
    const heap = v8.getHeapStatistics();
    if (heap.used_heap_size > peakUsedHeap) peakUsedHeap = heap.used_heap_size;
    heapLimit = heap.heap_size_limit;
    const rss = process.memoryUsage.rss();
    if (rss > peakRss) peakRss = rss;
  };
  const write = () => {
    try {
      sample();
      fs.writeFileSync(file, JSON.stringify({
        pid: process.pid, ppid: process.ppid, script: process.argv[1] ?? null,
        peakUsedHeapBytes: peakUsedHeap, heapSizeLimitBytes: heapLimit, peakRssBytes: peakRss,
        restartThresholdBytes: Math.floor(heapLimit * 0.8), sampledAt: new Date().toISOString(),
      }));
    } catch { /* Evidence only: never disturb the process it observes. */ }
  };
  setInterval(sample, 200).unref();
  setInterval(write, 1000).unref();
  process.on('exit', write);
}
