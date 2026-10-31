<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

class PreviewController extends Controller
{
    // Regression: the request only selects between two stored paths through a comparison.
    public function preview(Request $request, Upload $row)
    {
        $processed = $request->query('variant') === 'processed';
        $path = $processed ? $row->processed_path : $row->original_path;
        $disk = Storage::disk('private');
        abort_if($path === null || ! $disk->exists($path), 404);
        return response()->file($disk->path($path));
    }

    // Regression: fixed route plus the original query string is not an open redirect.
    public function legacy(Request $request, string $locale)
    {
        $qs = $request->getQueryString();
        return redirect()->to(Page::PATHS[$locale] . ($qs !== null && $qs !== '' ? '?' . $qs : ''), 301);
    }

    // Still a real open redirect.
    public function next(Request $request)
    {
        return redirect()->to($request->query('next')); // expect: sec/open-redirect
    }
}
