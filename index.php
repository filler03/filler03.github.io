<!DOCTYPE html>
<html>
<head>
 <title>HTML File Index</title>
</head>
<body>
 <h1>HTML File Index</h1>
 <ul>
 <?php
 $files = scandir('.');
 foreach ($files as $file) {
 if (pathinfo($file, PATHINFO_EXTENSION) == 'html') {
 echo '<li><a href="'"' . $file . '"'">' . $file . '</a></li>';
 }
 }
 ?>
 </ul>
</body>
</html>
