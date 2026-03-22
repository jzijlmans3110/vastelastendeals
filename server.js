const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({ status: 'werkt!', poort: process.env.PORT });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server draait op ' + PORT);
});
