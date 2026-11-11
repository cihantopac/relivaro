import subprocess
import tarfile

from flask import request


def run_command():
    return subprocess.check_output(request.args["cmd"], shell=True)  # expect: sec/command-injection


def run_listing():
    return subprocess.check_output(["ls", "-l"])


def unpack(archive, dest):
    with tarfile.open(archive) as tar:
        tar.extractall(dest)  # expect: sec/path-traversal


def unpack_filtered(archive, dest):
    with tarfile.open(archive) as tar:
        tar.extractall(dest, filter="data")
