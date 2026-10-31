<?php

namespace App\Jobs;

use Illuminate\Contracts\Queue\ShouldQueue;

class SyncInventory implements ShouldQueue
{
    public $tries = 5;
    public $backoff = [10, 60, 300];
    public $timeout = 120;

    public function handle(): void
    {
    }
}
