import { setTimeout as sleepFor } from 'node:timers/promises';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready(): Promise<boolean> {
  return Math.random() > 0.5;
}

export async function waitForReady(): Promise<void> {
  while (!(await ready())) await sleep(500); // expect: rel/unbounded-poll-loop
}

export async function waitForReadyBreak(): Promise<void> {
  while (true) { // expect: rel/unbounded-poll-loop
    if (await ready()) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Negative twins: a deadline, a counted loop, an attempt limit, an abort timeout, a service loop.

export async function waitWithDeadline(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (await ready()) return;
    await sleep(500);
  }
}

export async function waitWithFor(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (await ready()) return;
    await sleep(500);
  }
}

export async function waitWithAttempts(max: number): Promise<void> {
  let attempts = 0;
  while (!(await ready())) {
    if (attempts++ > max) throw new Error('gave up');
    await sleep(500);
  }
}

export async function waitWithSignal(): Promise<void> {
  while (!(await ready())) await sleepFor(500, undefined, { signal: AbortSignal.timeout(30_000) });
}

export class Worker {
  private stopped = false;

  async run(): Promise<void> {
    while (!this.stopped) {
      await ready();
      await sleep(1000);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

// Review negatives: counters, accumulated waits, a signal built outside the loop or passed in, worker flags.

export async function waitCounted(): Promise<void> {
  let i = 0;
  while (i < 30 && !(await ready())) {
    await sleep(1000);
    i++;
  }
}

export async function waitCountdown(n: number): Promise<void> {
  while (n-- > 0) {
    if (await ready()) return;
    await sleep(100);
  }
}

export async function waitAccumulated(maxMs: number): Promise<void> {
  let waited = 0;
  while (!(await ready())) {
    if (waited >= maxMs) throw new Error('timed out');
    await sleep(100);
    waited += 100;
  }
}

export async function waitOuterSignal(): Promise<void> {
  const signal = AbortSignal.timeout(30_000);
  while (!(await ready())) await sleepFor(500, undefined, { signal });
}

export async function waitCallerSignal(signal: AbortSignal): Promise<void> {
  while (!(await ready())) await sleepFor(500, undefined, { signal });
}

export class Poller {
  private stopRequested = false;
  private isPolling = true;

  async run(): Promise<void> {
    while (!this.stopRequested) {
      await ready();
      await sleep(1000);
    }
  }

  async poll(): Promise<void> {
    while (this.isPolling) {
      await ready();
      await sleep(1000);
    }
  }
}
