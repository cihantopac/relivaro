<?php
echo "<h1>Results for " . $_GET['q'] . "</h1>"; // expect: sec/xss
echo "<p>" . htmlspecialchars($_GET['q']) . "</p>";
