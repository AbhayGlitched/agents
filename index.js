const express = require('express');
const { chromium } = require('playwright'); // Import Playwright
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABSE_URL;
const supabaseAnonKey = process.env.SUPABSE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

let browser;
let page;
let browserMode = 'headless';

async function executeCommand(command) {
    if (!command) return false;
    
    try {
        switch (command.action) {
            case 'click':
                if (command.coordinates) {
                    await page.mouse.click(command.coordinates.x, command.coordinates.y);
                    await waitFor(500);
                }
                break;

            case 'type':
                if (command.text) {
                    await page.evaluate(() => {
                        document.activeElement.value = '';
                    });
                    await page.keyboard.type(command.text, { delay: 50 });
                    await waitFor(500);
                }
                break;

            case 'press':
                if (command.key) {
                    await page.keyboard.press(command.key);
                    await waitFor(500);
                }
                break;

            case 'scroll':
                if (command.pixels) {
                    await page.evaluate((pixels) => {
                        window.scrollBy(0, pixels);
                    }, command.pixels);
                    await waitFor(700);
                }
                break;

            case 'navigate':
                if (command.url) {
                    await page.goto(command.url);
                    await waitFor(1000);
                }
                break;

            case 'setValue':
                if (command.selector && command.value) {
                    await page.evaluate((selector, value) => {
                        const element = document.querySelector(selector);
                        if (element) {
                            element.value = value;
                            element.dispatchEvent(new Event('input'));
                        }
                    }, command.selector, command.value);
                    await waitFor(500);
                }
                break;

            case 'clearInput':
                await page.evaluate(() => {
                    if (document.activeElement) {
                        document.activeElement.value = '';
                    }
                });
                await waitFor(300);
                break;

            case 'waitForSelector':
                if (command.selector) {
                    await page.waitForSelector(command.selector, { timeout: 5000 });
                }
                break;

            default:
                console.log('No action needed');
                return true;
        }
        return true;
    } catch (error) {
        console.error('Error executing command:', error);
        return false;
    }
}

async function initBrowser(mode = 'headless') {
    if (browser) await browser.close();
    
    browserMode = mode;
    browser = await chromium.launch({
        headless: mode === 'headless',
        args: ['--no-sandbox', '--disable-setuid-sandbox' , '--disable-gpu']
    });
    
    page = await browser.newPage();
    
    // Add request interception
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.resourceType() === 'image' && request.url().includes('generate_204')) {
            request.abort();
        } else {
            request.continue();
        }
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://www.youtube.com');
}

async function takeScreenshot() {
    return await page.screenshot({ encoding: 'base64' });
}

async function getGeminiResponse(userMessage, screenshot) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
        
        const prompt = `You are a YouTube automation assistant. Analyze the screenshot and help with the following request:

"${userMessage}"

Respond with:
1. A friendly explanation of what you'll do
2. A command in this format:
COMMAND: {
    "action": "type|click|press|scroll|navigate|setValue|clearInput",
    // For click:
    "coordinates": {"x": number, "y": number},
    // For type/setValue:
    "text": "string",
    "selector": "CSS selector",
    // For scroll:
    "pixels": number,
    // For navigate:
    "url": "string"
}
    3. for searching  on youtube prefer url query method-- like type in the search page url directly
Focus on accuracy and user experience.`;

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: screenshot
                }
            }
        ]);

        const response = await result.response;
        const text = response.text();
        
        const parts = text.split('COMMAND:');
        return {
            conversation: parts[0].trim(),
            command: parts[1] ? JSON.parse(parts[1].trim()) : null
        };

    } catch (error) {
        console.error('Gemini API error:', error);
        return {
            conversation: "I'm having trouble processing that request. Could you try again?",
            command: null
        };
    }
}

function waitFor(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

app.post('/api/chat', async (req, res) => {
    try {
        const { message, username } = req.body;
        const screenshot = await takeScreenshot();
        const response = await getGeminiResponse(message, screenshot);
        
        await supabase
            .from('historyagents')
            .insert([{ 
                username: username || 'anonymous',
                message: message,
                ai_response: response.conversation,
                command: response.command ? JSON.stringify(response.command) : null,
                created_at: new Date().toISOString()
            }]);

        if (response.command) {
            await executeCommand(response.command);
            const newScreenshot = await takeScreenshot();
            res.json({
                response: response.conversation,
                screenshot: newScreenshot,
                success: true
            });
        } else {
            res.json({
                response: response.conversation,
                screenshot: screenshot,
                success: true
            });
        }
    } catch (error) {
        console.error('Chat API error:', error);
        res.status(500).json({ 
            response: "An error occurred while processing your request.",
            error: error.message,
            success: false
        });
    }
});

app.get('/api/screenshot', async (req, res) => {
    try {
        const screenshot = await takeScreenshot();
        res.json({ screenshot });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/history/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { data, error } = await supabase
            .from('historyagents')
            .select('*')
            .eq('username', username)
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        res.json({ history: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function start() {
    try {
        await initBrowser();
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Server startup error:', error);
        process.exit(1);
    }
}

process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});

start();

app.post('/api/toggle-headless', async (req, res) => {
    try {
        const newMode = browserMode === 'headless' ? 'normal' : 'headless';
        await initBrowser(newMode);
        res.json({ mode: newMode, success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
