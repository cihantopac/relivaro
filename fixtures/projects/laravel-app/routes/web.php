<?php

use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

Route::get('/users', [UserController::class, 'index']);
Route::get('/users/search', [UserController::class, 'search']);
Route::post('/users', [UserController::class, 'store'])->middleware('auth:sanctum');
