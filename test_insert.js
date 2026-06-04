require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function test() {
  const { data, error } = await supabase.from('series').insert({
    title: 'Test Anime',
    description: 'Test Description',
    cover_url: 'https://test.com/image.jpg',
    genre: ['Action']
  }).select();
  
  if (error) console.error('ERROR:', error);
  else console.log('SUCCESS:', data);
}
test();
