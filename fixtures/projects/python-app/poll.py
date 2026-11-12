import asyncio
import time


def done() -> bool:
    return time.time() % 2 > 1


async def wait_until_done():
    while not done():  # expect: rel/unbounded-poll-loop
        await asyncio.sleep(1)


async def wait_with_deadline(seconds: float):
    deadline = time.monotonic() + seconds
    while not done():
        if time.monotonic() > deadline:
            raise TimeoutError("not done")
        await asyncio.sleep(1)


def wait_with_tries(max_tries: int):
    tries = 0
    while not done():
        tries += 1
        if tries > max_tries:
            raise TimeoutError("not done")
        time.sleep(1)


def wait_counted():
    for _ in range(10):
        if done():
            return
        time.sleep(1)
