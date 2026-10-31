<?php

return [
    'paths' => ['api/*'],
    'allowed_origins' => ['*'],
    'supports_credentials' => true, // expect: sec/cors-misconfiguration
];
