<?php

namespace App\Http\Controllers;

use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class OrderController extends Controller
{
    public function index(Request $request)
    {
        return Order::with('items')->latest()->paginate(20);
    }

    public function store(Request $request)
    {
        $data = $request->validate(['total' => 'required|integer', 'note' => 'nullable|string']);
        return Order::create($data);
    }

    public function report(Request $request)
    {
        $status = $request->input('status');
        return DB::select('SELECT COUNT(*) AS c FROM orders WHERE status = ?', [$status]);
    }

    public function export()
    {
        $orders = Order::with('items')->get();
        $count = Order::count();
        return ['count' => $count, 'orders' => $orders->map(fn ($o) => $o->items->count())];
    }

    public function show(string $id)
    {
        return e(Order::findOrFail($id)->note);
    }
}
