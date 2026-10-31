<?php

return [
    'driver' => env('SESSION_DRIVER', 'file'),
    'secure' => env('SESSION_SECURE_COOKIE'),
    'http_only' => false, // expect: sec/insecure-cookie
];
