import os

try:
    import numpy  # noqa: F401
except ImportError:
    pass


def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
