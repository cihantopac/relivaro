import os

DEBUG = True  # expect: sec/debug-mode-enabled
SECRET_KEY = 'django-insecure-9x!k2l@m4n#p6q8r0s2t4u6v8w0y2z4a6'  # expect: sec/hardcoded-signing-secret
ALLOWED_HOSTS = ['shop.example.com']
DATABASE_PASSWORD = os.environ['DATABASE_PASSWORD']
SENTRY_DSN = os.environ.get('SENTRY_DSN', '')
