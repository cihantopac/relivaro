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
