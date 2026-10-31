<?php

namespace App\Http\Controllers;

use App\Models\Account;
use App\Models\Post;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

class UserController extends Controller
{
    public function index()
    {
        return User::all(); // expect: perf/unbounded-query
    }

    public function paginated()
    {
        return User::query()->latest()->paginate(25);
    }

    public function search(Request $request)
    {
        $users = DB::select("SELECT * FROM users WHERE name = '" . $request->input('name') . "'"); // expect: sec/sql-injection
        $sorted = User::orderByRaw($request->input('sort'))->get(); // expect: sec/sql-injection
        $safe = DB::select('SELECT * FROM users WHERE name = ?', [$request->input('name')]);
        $table = 'users';
        $count = DB::select("SELECT COUNT(*) AS c FROM {$table}");
        return [$users, $sorted, $safe, $count];
    }

    public function store(Request $request)
    {
        $user = User::create($request->all()); // expect: sec/mass-assignment
        $other = User::create($request->only(['name', 'email']));
        return [$user, $other];
    }

    public function stats()
    {
        $active = User::where('active', 1)->get()->count(); // expect: perf/load-all-to-count
        $fast = User::where('active', 1)->count();
        foreach (Post::all() as $post) { // expect: perf/unbounded-query
            $author = User::find($post->user_id); // expect: perf/query-in-loop
            $comments = $post->comments()->get(); // expect: perf/query-in-loop
        }
        return [$active, $fast];
    }

    public function export(Request $request)
    {
        $data = unserialize($request->input('payload')); // expect: sec/unsafe-deserialization
        $cached = unserialize(cache('report'), ['allowed_classes' => false]);
        dd($data, $cached); // expect: qual/debug-statement
    }

    public function avatar(Request $request)
    {
        return response()->download(storage_path('avatars/' . $request->input('file'))); // expect: sec/path-traversal
    }

    public function back(Request $request)
    {
        return redirect($request->input('next')); // expect: sec/open-redirect
    }

    public function home()
    {
        return redirect('/dashboard');
    }

    public function ping(Request $request)
    {
        return shell_exec('ping -c 1 ' . $request->input('host')); // expect: sec/command-injection
    }

    public function pingSafe(Request $request)
    {
        return shell_exec('ping -c 1 ' . escapeshellarg($request->input('host')));
    }

    public function fetch(Request $request)
    {
        return Http::get($request->input('url'))->body(); // expect: sec/ssrf
    }

    public function withdraw(Request $request, Account $account)
    {
        $account->balance = $account->balance - $request->input('amount'); // expect: rel/race-condition-read-modify-write
        $account->save();
    }

    public function deposit(Request $request, Account $account)
    {
        $account->increment('balance', $request->integer('amount'));
    }

    public function legacyHash(Request $request)
    {
        return md5($request->input('password')); // expect: sec/weak-password-hash
    }

    public function token()
    {
        $resetToken = mt_rand(100000, 999999); // expect: sec/insecure-random
        return $resetToken;
    }
}
