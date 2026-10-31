<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;

class LegacyRouteController extends Controller
{
    // Regression: route() builds a same-origin URL; only the query string is carried over.
    public function __invoke(Request $request)
    {
        $route = $request->route();
        $url = route((string) $route->defaults['to'], Arr::except($route->parameters(), ['to']));
        $query = (string) $request->server->get('QUERY_STRING', '');
        return redirect()->to($url . ($query !== '' ? '?' . $query : ''), 301);
    }

    // Regression: SQL fragments chosen between literals are constants.
    public function board(?string $from)
    {
        if ($from === null) {
            $cond = '1 = 1';
        } else {
            $cond = 'published_at >= ?';
        }
        return DB::table('items')->selectRaw("count(*) filter (where {$cond}) as total")->get();
    }
}
