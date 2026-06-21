const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Initialize Anthropic
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ============ VENDORS ============

// Get all vendors with filtering
app.get('/api/vendors', async (req, res) => {
  try {
    const { category, search, taa_verified, made_in_usa, berry_act } = req.query;
    
    let query = supabase.from('vendors').select('*');
    
    if (category) {
      query = query.eq('category', category);
    }
    if (taa_verified === 'true') {
      query = query.eq('taa_verified', true);
    }
    if (made_in_usa === 'true') {
      query = query.eq('made_in_usa', true);
    }
    if (berry_act === 'true') {
      query = query.eq('berry_act_eligible', true);
    }
    if (search) {
      query = query.or(`name.ilike.%${search}%,cage_code.ilike.%${search}%,description.ilike.%${search}%`);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single vendor
app.get('/api/vendors/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('id', req.params.id)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create vendor (admin only - requires valid invite code for now)
app.post('/api/vendors', async (req, res) => {
  try {
    const { cage_code, name, location, website, description, made_in_usa, taa_verified, berry_act_eligible, category, business_size, employees } = req.body;
    
    const { data, error } = await supabase
      .from('vendors')
      .insert([{
        cage_code,
        name,
        location,
        website,
        description,
        made_in_usa,
        taa_verified,
        berry_act_eligible,
        category,
        business_size,
        employees
      }])
      .select();
    
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update vendor
app.put('/api/vendors/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .update(req.body)
      .eq('id', req.params.id)
      .select();
    
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete vendor
app.delete('/api/vendors/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('vendors')
      .delete()
      .eq('id', req.params.id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ VENDOR RESEARCH (ADMIN) ============

// Research and populate vendor data using Claude web search
app.post('/api/research-vendors', async (req, res) => {
  try {
    const { companies } = req.body;
    const vendors = [];
    
    if (!companies || !Array.isArray(companies) || companies.length === 0) {
      return res.json({ vendors: [] });
    }
    
    for (const company of companies) {
      try {
        console.log('Researching:', company.name);
        
        // Call Claude with web_search
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          tools: [{ type: 'web_search', name: 'web_search' }],
          messages: [{
            role: 'user',
            content: `Search the web for "${company.name}" and return ONLY this JSON (no markdown):
{
  "name": "Official company name",
  "website": "Main website URL or empty string",
  "description": "1-2 sentence description",
  "category": "Product category or industry",
  "location": "City, Country"
}`
          }]
        });
        
        // Extract text from response
        let text = '';
        for (const block of response.content) {
          if (block.type === 'text') {
            text = block.text;
            break;
          }
        }
        
        // Parse JSON
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const vendor = JSON.parse(jsonMatch[0]);
          vendor.product_images = [];
          vendors.push(vendor);
          console.log('Success:', vendor.name);
        }
      } catch (e) {
        console.error('Error researching', company.name, ':', e.message);
      }
    }
    
    res.json({ vendors });
  } catch (error) {
    console.error('Error:', error.message);
    res.json({ vendors: [] });
  }
});

// ============ CONTACT INQUIRIES ============

// Submit contact inquiry
app.post('/api/contact-inquiry', async (req, res) => {
  try {
    const { vendor_id, user_email, user_name, user_company, user_phone, inquiry_type, message } = req.body;
    
    // Save to database
    const { data: inquiry, error: dbError } = await supabase
      .from('contact_inquiries')
      .insert([{
        vendor_id,
        user_email,
        user_name,
        user_company,
        user_phone,
        inquiry_type,
        message
      }])
      .select();
    
    if (dbError) throw dbError;
    
    // Get vendor info for email
    const { data: vendor } = await supabase
      .from('vendors')
      .select('name')
      .eq('id', vendor_id)
      .single();
    
    // Send email to info@americainnovates.com
    await sgMail.send({
      to: 'info@americainnovates.com',
      from: 'noreply@source.americainnovates.com',
      subject: `New Inquiry: ${vendor?.name || 'Unknown Vendor'}`,
      html: `
        <h2>New Contact Inquiry</h2>
        <p><strong>Vendor:</strong> ${vendor?.name}</p>
        <p><strong>From:</strong> ${user_name} (${user_email})</p>
        <p><strong>Company:</strong> ${user_company || 'Not provided'}</p>
        <p><strong>Phone:</strong> ${user_phone || 'Not provided'}</p>
        <p><strong>Inquiry Type:</strong> ${inquiry_type}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `
    });
    
    // Also send confirmation to user
    await sgMail.send({
      to: user_email,
      from: 'noreply@source.americainnovates.com',
      subject: `We received your inquiry to ${vendor?.name}`,
      html: `
        <h2>Thank you for your interest!</h2>
        <p>Hi ${user_name},</p>
        <p>We've received your inquiry to <strong>${vendor?.name}</strong>. They will be in touch within 1-2 business days.</p>
        <p>Best regards,<br>SOURCE by America Innovates</p>
      `
    });
    
    res.json({ success: true, inquiry: inquiry[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ AI ASSISTANT ============

// Chat with AI assistant (context-aware)
app.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    // Build system prompt based on context
    let systemPrompt = `You are the SOURCE Assistant, an AI helper for America Innovates' vendor sourcing platform. 
    You help users find vendors, understand compliance requirements, and draft professional inquiries.
    Keep responses concise and actionable. Always be helpful and professional.`;
    
    if (context === 'vendor-profile') {
      systemPrompt += `\n\nYou are currently helping a user view a vendor profile. You can answer questions about that vendor's capabilities, compliance, certifications, and help them draft inquiries.`;
    } else if (context === 'contact-form') {
      systemPrompt += `\n\nYou are currently helping a user draft a professional inquiry. Suggest professional language and what key information to include.`;
    } else if (context === 'main-directory') {
      systemPrompt += `\n\nYou are helping a user search and filter vendors. Help them find vendors matching their needs across 13 categories.`;
    }
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: [
        { role: 'user', content: message }
      ]
    });
    
    res.json({ 
      response: response.content[0].type === 'text' ? response.content[0].text : ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ INVITE CODES ============

// Create invite code (admin only)
app.post('/api/invite-codes', async (req, res) => {
  try {
    const { email } = req.body;
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();
    
    const { data, error } = await supabase
      .from('invite_codes')
      .insert([{ code, email }])
      .select();
    
    if (error) throw error;
    
    // Generate signup link
    const signupLink = `${process.env.FRONTEND_URL}?invite=${code}`;
    
    res.json({ 
      code: data[0].code,
      signupLink,
      email
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validate invite code
app.post('/api/validate-invite', async (req, res) => {
  try {
    const { code } = req.body;
    
    const { data, error } = await supabase
      .from('invite_codes')
      .select('*')
      .eq('code', code)
      .single();
    
    if (error || !data) {
      return res.status(400).json({ valid: false, error: 'Invalid invite code' });
    }
    
    if (data.used) {
      return res.status(400).json({ valid: false, error: 'Invite code already used' });
    }
    
    if (new Date(data.expires_at) < new Date()) {
      return res.status(400).json({ valid: false, error: 'Invite code expired' });
    }
    
    res.json({ valid: true, email: data.email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SOURCE backend running on port ${PORT}`);
});
