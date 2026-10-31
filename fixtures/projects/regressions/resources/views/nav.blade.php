@foreach ($periods as $p)
    <a href="?p={{ $p }}"{!! $p === $period ? ' aria-current="page"' : '' !!}>{{ $p }}</a>
@endforeach
