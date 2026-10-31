import logging
import subprocess

import requests
import yaml

log = logging.getLogger(__name__)


def fetch_rates():
    return requests.get('https://rates.example.com/latest', timeout=10).json()


def load_config(path):
    with open(path) as f:
        return yaml.safe_load(f)


def archive(directory):
    subprocess.run(['tar', '-czf', 'backup.tgz', directory], check=True)


def safe_divide(a, b):
    try:
        return a / b
    except ZeroDivisionError:
        log.warning('division by zero')
        return None
