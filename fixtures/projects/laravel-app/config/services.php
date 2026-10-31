<?php

return [
    'stripe' => ['secret' => env('STRIPE_SECRET')],
    'mailgun' => ['domain' => env('MAILGUN_DOMAIN', 'mg.example.com')],
];
