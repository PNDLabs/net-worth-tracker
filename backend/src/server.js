const { createApp } = require('./app');

const PORT = process.env.PORT || 3001;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Net Worth Tracker API running on http://localhost:${PORT}`);
});
