import hashlib
import os
import pickle
import random
import secrets
import sqlite3
import subprocess

import requests
import yaml
from flask import Flask, redirect, render_template_string, request

app = Flask(__name__)
app.secret_key = 'flask-hardcoded-secret-key-123'  # expect: sec/hardcoded-signing-secret


@app.route('/user')
def user():
    conn = sqlite3.connect('db.sqlite')
    cur = conn.cursor()
    cur.execute(f"SELECT * FROM users WHERE id = {request.args['id']}")  # expect: sec/sql-injection
    cur.execute("SELECT * FROM users WHERE id = ?", (request.args['id'],))
    return str(cur.fetchall())


@app.route('/run')
def run():
    cmd = request.args.get('cmd')
    return subprocess.check_output(f"ls {cmd}", shell=True)  # expect: sec/command-injection


@app.route('/run-safe')
def run_safe():
    return subprocess.check_output(['ls', request.args.get('dir', '.')])


@app.route('/fetch')
def fetch():
    r = requests.get(request.args['url'])  # expect: sec/ssrf rel/http-call-without-timeout
    return r.text


@app.route('/status')
def status():
    r = requests.get('https://status.example.com/api', timeout=5)
    return r.text


@app.route('/load', methods=['POST'])
def load():
    data = pickle.loads(request.data)  # expect: sec/unsafe-deserialization
    cfg = yaml.load(request.data)  # expect: sec/unsafe-deserialization
    safe = yaml.safe_load(request.data)
    return str([data, cfg, safe])


@app.route('/go')
def go():
    return redirect(request.args.get('next'))  # expect: sec/open-redirect


@app.route('/hello')
def hello():
    return render_template_string('<h1>Hello ' + request.args.get('name', '') + '</h1>')  # expect: sec/template-injection


@app.route('/file')
def file():
    with open(os.path.join('uploads', request.args['name'])) as f:  # expect: sec/path-traversal
        return f.read()


def hash_password(password):
    return hashlib.md5(password.encode()).hexdigest()  # expect: sec/weak-password-hash


def cache_key(url):
    return hashlib.sha1(url.encode()).hexdigest()


def make_reset_token():
    reset_token = random.randint(100000, 999999)  # expect: sec/insecure-random
    return reset_token


def make_session_id():
    return secrets.token_urlsafe(32)


def sample_ids(ids):
    sample = random.sample(ids, 3)
    return sample


def sync():
    try:
        requests.post('https://api.example.com/sync', json={}, verify=False)  # expect: sec/tls-verification-disabled rel/http-call-without-timeout
    except:  # expect: rel/bare-except rel/swallowed-exception
        pass


def tolerant_cleanup(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        # already gone: nothing to do
        pass


def calc(expr):
    return eval(expr)  # expect: sec/code-injection


if __name__ == '__main__':
    breakpoint()  # expect: qual/debug-statement
    app.run(debug=True)  # expect: sec/debug-mode-enabled
