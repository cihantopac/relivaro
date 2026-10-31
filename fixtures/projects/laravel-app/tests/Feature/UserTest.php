<?php

namespace Tests\Feature;

use Tests\TestCase;

class UserTest extends TestCase
{
    public function test_index(): void
    {
        $this->get('/users')->assertOk();
    }
}
