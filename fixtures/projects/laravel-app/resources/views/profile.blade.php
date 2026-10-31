<form method="POST">
    {!! csrf_field() !!}
    <h1>{{ $user->name }}</h1>
    <div class="bio">{!! $user->bio !!}</div> {{-- expect: sec/template-unescaped-output --}}
    {!! $posts->links() !!}
</form>
