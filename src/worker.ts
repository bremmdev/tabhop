import { parentPort, workerData } from 'node:worker_threads';
import { renderFrames } from './video.ts';

const { song, opts, from, to, out } = workerData;
let last = 0;
await renderFrames(song, opts, from, to, out, (done) => {
  if (done - last >= 10 || done === to - from) {
    last = done;
    parentPort!.postMessage({ done });
  }
});
parentPort!.postMessage({ finished: true });
