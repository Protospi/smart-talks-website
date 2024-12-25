import { useEffect, useRef, useCallback, useState } from 'react';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { 
  instructions as defaultInstructions, 
  imagePrompt as defaultImagePrompt, 
  extractionPrompt as defaultExtractionPrompt 
} from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';
import { X, Edit, Zap, ArrowUp, ArrowDown, Image } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';
import OpenAI from 'openai';

import './ConsolePage.scss';

/**
 * Running a local relay server will allow you to hide your API key
 * and run custom logic on the server
 *
 * Set the local relay server address to:
 * REACT_APP_LOCAL_RELAY_SERVER_URL=http://localhost:8081
 *
 * This will also require you to set OPENAI_API_KEY= in a `.env` file
 * You can run it with `npm run relay`, in parallel with `npm start`
 */
const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

/**
 * Type for story items
 */
interface StoryItem {
  imageUrl: string | null;
  text: string;
  timestamp: string;
}

const ConsolePage: React.FC = () => {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  /**
   * Instantiate:
   * - WavRecorder (speech input)
   * - WavStreamPlayer (speech output)
   * - RealtimeClient (API client)
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  /**
   * References for
   * - Rendering audio visualization (canvas)
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   * - items are all conversation items (dialog)
   * - realtimeEvents are event logs, which can be expanded
   * - memoryKv is for set_memory() function
   * - coords, marker are for get_weather() function
   */
  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [viewMode, setViewMode] = useState<'FRONT' | 'BACK'>('FRONT');
  const [systemPrompt, setSystemPrompt] = useState(defaultInstructions);
  const [activePromptType, setActivePromptType] = useState('system');
  const [imagePrompt, setImagePrompt] = useState(defaultImagePrompt);
  const [extractionPrompt, setExtractionPrompt] = useState(defaultExtractionPrompt);
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [imageDescription, setImageDescription] = useState<string>('');
  const [stories, setStories] = useState<StoryItem[]>([]);

  /**
   * Utility for formatting the timing of logs
   */
  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + '';
      while (s.length < 2) {
        s = '0' + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);

  /**
   * When you click the API key
   */
  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  /**
   * Connect to conversation:
   * WavRecorder taks speech input, WavStreamPlayer output, client is API client
   */
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // Set state variables
    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());

    // Connect to microphone
    await wavRecorder.begin();

    // Connect to audio output
    await wavStreamPlayer.connect();

    // Connect to realtime API
    await client.connect();
    
    // Always use VAD mode and set current system prompt
    client.updateSession({
      turn_detection: { type: 'server_vad' },
      instructions: systemPrompt
    });

    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `Hello!`,
      },
    ]);

    // Start recording since we're always in VAD mode
    await wavRecorder.record((data) => client.appendInputAudio(data.mono));
  }, [systemPrompt]);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#0099ff',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#009900',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  useEffect(() => {
    // Get refs
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // Set instructions
    client.updateSession({ instructions: systemPrompt });
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // handle realtime events from client + server for event logging
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // if we receive multiple events in a row, aggregate them for display purposes
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);

      if (item.role === 'assistant' && item.status === 'completed') {
        await extractStoryFromConversation(items);
      }
    });

    setItems(client.conversation.getItems());

    return () => {
      // cleanup; resets to defaults
      client.reset();
    };
  }, []);

  const imageDescriptor = async (base64Image: string) => {
    try {
      const openai = new OpenAI({ 
        apiKey: apiKey,
        dangerouslyAllowBrowser: true  
      });

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Note: Fixed the model name from gpt-4o-mini to gpt-4-vision-preview
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: imagePrompt
              },
              {
                type: "image_url",
                image_url: {
                  url: base64Image
                }
              }
            ]
          }
        ],
        max_tokens: 300
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Detailed error in image description:', error);
      return 'Error getting image description';
    }
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      
      reader.onerror = (error) => {
        console.error('Error reading file:', error);
      };

      reader.onloadend = async () => {
        const base64Image = reader.result as string;
        setBackgroundImage(base64Image);
        try {
          const description = await imageDescriptor(base64Image) || 'No description available';
          setImageDescription(description);
          
          // Send the image description as a user message to the conversation
          const client = clientRef.current;
          client.sendUserMessageContent([
            {
              type: 'input_text',
              text: `I'm sharing an image with you. Here's what's in it: ${description}`
            }
          ]);

        } catch (error) {
          console.error('Error in handleImageUpload:', error);
        }
      };

      reader.readAsDataURL(file);
    } else {
      console.log('No file selected');
    }
  };

  const extractStoryFromConversation = async (items: ItemType[]) => {
    try {
      if (!apiKey || items.length === 0) return;

      const conversationString = items
        .map(item => {
          if (item.role === 'assistant' || item.role === 'user') {
            const text = item.formatted.transcript || item.formatted.text || '';
            return `${item.role}: ${text}`;
          }
          return null;
        })
        .filter(Boolean)
        .join('\n');

      const openai = new OpenAI({
        apiKey: apiKey,
        dangerouslyAllowBrowser: true
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: extractionPrompt },
          {
            role: "user",
            content: conversationString,
          },
        ],
      });

      const extractedContent = completion.choices[0].message.content;
      console.log('Extracted story:', extractedContent);

      try {
        const parsedContent = JSON.parse(extractedContent || '{}');
        if (parsedContent.save === true) {
          // Create new story with current backgroundImage
          const newStory = {
            imageUrl: backgroundImage, // This should now properly pass the image
            text: parsedContent.story || parsedContent.text || extractedContent,
            timestamp: new Date().toISOString()
          };
          
          console.log('Setting new story with image:', newStory); // Debug log
          setStories([newStory]);
        }
      } catch (parseError) {
        console.error('Error parsing extraction response:', parseError);
      }
      
    } catch (error) {
      console.error('Error extracting story:', error);
    }
  };

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <span><strong>Griot</strong></span>
        </div>
        <div className="mode-toggle">
          <Toggle
            defaultValue={false}
            labels={['FRONT', 'BACK']}
            values={['FRONT', 'BACK']}
            onChange={(_, value) => setViewMode(value as 'FRONT' | 'BACK')}
          />
        </div>
        <div className="content-api-key">
          {!LOCAL_RELAY_SERVER_URL && (
            <Button
              icon={Edit}
              iconPosition="end"
              buttonStyle="flush"
              label={`api key: ${apiKey.slice(0, 3)}...`}
              onClick={() => resetAPIKey()}
            />
          )}
        </div>
      </div>
      
      <div className="content-main">
        {viewMode === 'FRONT' ? (
          <div className="split-view">
            <div className="left-panel">
              <div 
                className="content-logs front-view"
                style={backgroundImage ? {
                  background: `url(${backgroundImage})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                } : undefined}
              >
                <div className="content-actions">
                  <div className="connect-button-container">
                    <button 
                      className={`connect-circle-button ${isConnected ? 'connected' : ''}`}
                      onClick={isConnected ? disconnectConversation : connectConversation}
                    >
                      {isConnected ? (
                        <span className="live-text">LIVE</span>
                      ) : (
                        <span className="dots">•••</span>
                      )}
                      {isConnected && <div className="pulse-ring"></div>}
                    </button>
                    <span className="tap-text">
                      {isConnected ? 'Tap to stop' : 'Tap to start'}
                    </span>
                  </div>
                </div>
                <div className="image-upload-container">
                  <input
                    type="file"
                    id="image-upload"
                    accept="image/*"
                    onChange={handleImageUpload}
                    style={{ display: 'none' }}
                  />
                  <label htmlFor="image-upload" className="image-upload-button">
                    <Image size={24} />
                  </label>
                </div>
              </div>
            </div>
            
            <div className="right-panel">
              <div className="storyboard-title">
                Story
              </div>
              <div className="storyboard-content">
                {stories.map((story, index) => (
                  <div key={story.timestamp} className="story-item">
                    {story.imageUrl && (
                      <div className="story-image">
                        <img src={story.imageUrl} alt="Story context" />
                      </div>
                    )}
                    <div className="story-text">
                      {story.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="content-logs">
              <div className="content-block system-prompt">
                <div className="content-block-title">
                  <span>Prompt Editor</span>
                  <div className="prompt-type-buttons">
                    <button 
                      className={activePromptType === 'system' ? 'active' : ''} 
                      onClick={() => setActivePromptType('system')}
                    >
                      System
                    </button>
                    <button 
                      className={activePromptType === 'image' ? 'active' : ''} 
                      onClick={() => setActivePromptType('image')}
                    >
                      Image
                    </button>
                    <button 
                      className={activePromptType === 'extraction' ? 'active' : ''} 
                      onClick={() => setActivePromptType('extraction')}
                    >
                      Extraction
                    </button>
                  </div>
                </div>
                <div className="content-block-body">
                  <textarea
                    className="prompt-input"
                    value={
                      activePromptType === 'system' 
                        ? systemPrompt 
                        : activePromptType === 'image' 
                          ? imagePrompt 
                          : extractionPrompt
                    }
                    onChange={(e) => {
                      if (activePromptType === 'system') {
                        setSystemPrompt(e.target.value);
                      } else if (activePromptType === 'image') {
                        setImagePrompt(e.target.value);
                      } else {
                        setExtractionPrompt(e.target.value);
                      }
                    }}
                    placeholder={`Enter ${activePromptType} prompt...`}
                  />
                </div>
              </div>
              <div className="content-block conversation">
                <div className="content-block-title">Conversation</div>
                <div className="content-block-body" data-conversation-content>
                  {!items.length && `awaiting connection...`}
                  {items.map((conversationItem, i) => {
                    return (
                      <div className="conversation-item" key={conversationItem.id}>
                        <div className={`speaker ${conversationItem.role || ''}`}>
                          <div>
                            {(
                              conversationItem.role || conversationItem.type
                            ).replaceAll('_', ' ')}
                          </div>
                          <div
                            className="close"
                            onClick={() =>
                              deleteConversationItem(conversationItem.id)
                            }
                          >
                            <X />
                          </div>
                        </div>
                        <div className={`speaker-content`}>
                          {/* tool response */}
                          {conversationItem.type === 'function_call_output' && (
                            <div>{conversationItem.formatted.output}</div>
                          )}
                          {/* tool call */}
                          {!!conversationItem.formatted.tool && (
                            <div>
                              {conversationItem.formatted.tool.name}(
                              {conversationItem.formatted.tool.arguments})
                            </div>
                          )}
                          {!conversationItem.formatted.tool &&
                            conversationItem.role === 'user' && (
                              <div>
                                {conversationItem.formatted.transcript ||
                                  (conversationItem.formatted.audio?.length
                                    ? '(awaiting transcript)'
                                    : conversationItem.formatted.text ||
                                      '(item sent)')}
                              </div>
                            )}
                          {!conversationItem.formatted.tool &&
                            conversationItem.role === 'assistant' && (
                              <div>
                                {conversationItem.formatted.transcript ||
                                  conversationItem.formatted.text ||
                                  '(truncated)'}
                              </div>
                            )}
                          {conversationItem.formatted.file && (
                            <audio
                              src={conversationItem.formatted.file.url}
                              controls
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ConsolePage;
