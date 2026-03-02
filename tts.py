#!/usr/bin/env python3
"""
JanJan TTS Engine — exact same as gnslgbot2's speech_recognition_cog
Uses: edge_tts.Communicate(text, voice, rate="+10%", volume="+30%")
Called by index.js via: python3 tts.py "<text>" "<voice>" "<outputfile>"
"""

import sys
import asyncio
import edge_tts

async def main():
    if len(sys.argv) < 4:
        print("Usage: tts.py <text> <voice> <output_file>", file=sys.stderr)
        sys.exit(1)

    text = sys.argv[1]
    voice = sys.argv[2]
    output_file = sys.argv[3]

    # Exact same parameters as gnslgbot2's speech_recognition_cog.py line 805:
    # tts = edge_tts.Communicate(text=message, voice=voice, rate="+10%", volume="+30%")
    tts = edge_tts.Communicate(text=text, voice=voice, rate="+10%", volume="+30%")
    await tts.save(output_file)

if __name__ == "__main__":
    asyncio.run(main())
