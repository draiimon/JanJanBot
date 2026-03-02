#!/usr/bin/env python3
"""
JanJan STT Engine — same as gnslgbot2's speech_recognition_cog
Uses: speech_recognition with Google STT (Filipino + English)
Called by index.js via: python3 stt.py <wavfile>
Outputs: transcribed text to stdout (empty if nothing recognized)
"""

import sys
import speech_recognition as sr

def main():
    if len(sys.argv) < 2:
        print("Usage: stt.py <wav_file>", file=sys.stderr)
        sys.exit(1)

    wav_file = sys.argv[1]
    r = sr.Recognizer()
    r.energy_threshold = 300
    r.dynamic_energy_threshold = True

    try:
        with sr.AudioFile(wav_file) as source:
            audio = r.record(source)
    except Exception as e:
        print(f"STT Error reading file: {e}", file=sys.stderr)
        sys.exit(0)

    # Try Filipino first (same priority as gnslgbot2), then English
    for lang in ['fil', 'en-US']:
        try:
            text = r.recognize_google(audio, language=lang)
            if text and text.strip():
                print(text.strip())
                sys.exit(0)
        except sr.UnknownValueError:
            continue
        except sr.RequestError as e:
            print(f"STT request error: {e}", file=sys.stderr)
            sys.exit(0)

    # Nothing recognized
    sys.exit(0)

if __name__ == '__main__':
    main()
