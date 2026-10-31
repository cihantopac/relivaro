<?php

namespace App\Jobs;

use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;

class SendNewsletter implements ShouldQueue // expect: rel/queue-job-without-retry-policy
{
    use Dispatchable;

    public function handle(): void
    {
        //
    }
}
