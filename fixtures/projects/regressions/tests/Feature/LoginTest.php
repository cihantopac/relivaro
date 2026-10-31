<?php

namespace Tests\Feature;

use Tests\TestCase;

class LoginTest extends TestCase
{
    public function test_login(): void
    {
        // Regression: fake user passwords in tests are not secrets.
        $this->post('/login', ['email' => 'kid@example.test', 'password' => 'right-horse-battery-77'])->assertRedirect();
    }
}
