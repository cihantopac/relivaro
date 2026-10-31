<?php

namespace App\Support;

final class MailMarkdown
{
    public static function links(string $text): string
    {
        // Regression: negated class and escaped pair are disjoint, no catastrophic backtracking.
        return preg_replace('/(?<!\\\\)\[((?:[^\]\\\\]|\\\\.)+)\]\(([^)\s]+)\)/', '<a href="$2">$1</a>', $text);
    }

    public static function blocks(string $text): array
    {
        preg_match('/^items:\n((?:[ \t]+.*\n?)+)/m', $text, $m); // expect: perf/regex-catastrophic-backtracking
        return $m;
    }
}
