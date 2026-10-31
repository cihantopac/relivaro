<?php

namespace App\Services;

use GuzzleHttp\Client;

class PaymentService
{
    public function client(): Client
    {
        return new Client(['base_uri' => 'https://api.payments.example']); // expect: rel/http-call-without-timeout
    }

    public function safeClient(): Client
    {
        return new Client(['base_uri' => 'https://api.payments.example', 'timeout' => 10]);
    }

    public function legacy(string $url)
    {
        $ch = curl_init($url); // expect: rel/http-call-without-timeout
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // expect: sec/tls-verification-disabled
        return curl_exec($ch);
    }

    public function charge(\Stripe\StripeClient $stripe, int $amount)
    {
        return $stripe->paymentIntents->create(['amount' => $amount, 'currency' => 'eur']); // expect: rel/payment-without-idempotency-key
    }

    public function chargeSafe(\Stripe\StripeClient $stripe, int $amount, string $orderId)
    {
        return $stripe->paymentIntents->create(['amount' => $amount, 'currency' => 'eur'], ['idempotency_key' => $orderId]);
    }
}
