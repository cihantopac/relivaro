<?php

namespace Database\Seeders;

use App\Models\Item;
use Illuminate\Database\Seeder;

class CatalogSeeder extends Seeder
{
    public function run(): void
    {
        foreach (['a', 'b', 'c'] as $slug) {
            // Regression: N+1 in an offline seeder is reported with low severity and confidence only.
            if (Item::where('slug', $slug)->exists()) { // expect: perf/query-in-loop
                continue;
            }
        }
    }
}
