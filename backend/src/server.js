require('dotenv').config();
const { createApp } = require('./app');

const PORT = process.env.PORT || 3001;
const app = createApp();

app.listen(PORT, () => {
  const aiStatus = process.env.AI_API_KEY || process.env.OPENAI_API_KEY ? 'AI-assisted parsing enabled' : 'Pattern-based parsing (no AI key set)';
  console.log(`Net Worth Tracker API running on http://localhost:${PORT}`);
  console.log(`PDF Import: ${aiStatus}`);
});
