<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\Validator;

class SignupController extends Controller
{
    public function check(array $rows)
    {
        $messages = [];
        foreach ($rows as $row) {
            $validator = Validator::make($row, ['email' => 'required|email']);
            // Regression: a validator error bag is not a relationship query.
            $messages[] = $validator->errors()->first();
        }
        return $messages;
    }
}
