<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('legacy_id'); // expect: rel/destructive-migration
            $table->string('phone'); // expect: rel/destructive-migration
            $table->string('nickname')->nullable();
            $table->boolean('verified')->default(false);
        });
    }

    public function down(): void // expect: rel/migration-without-rollback
    {
    }
};
