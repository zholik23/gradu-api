import json
import numpy as np
import torch
import os
import asyncio
import sys # <<< Import sys to access command-line arguments
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer, util
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

PRIMARY_THRESHOLD = 0.40
SECONDARY_THRESHOLD = 0.60

class IntentClassifier:
    # <<< Added a 'verbose' parameter to control printing
    def __init__(self, rules_filepath, verbose=True):
        if verbose: print("Initializing classifier...")
        try:
            genai.configure(api_key=os.environ["GEMINI_API_KEY"])
            self.gemini_model = genai.GenerativeModel('gemini-2.0-flash')
            if verbose: print("- Gemini client configured successfully.")
        except Exception as e:
            self.gemini_model = None
            if verbose: print(f"🛑 WARNING: Could not configure Gemini client: {e}. Fallback will be skipped.")

        self.rules = self._load_rules(rules_filepath)
        self._initialize_primary_matcher(verbose)
        self._initialize_secondary_matcher(verbose)
        self.gemini_intent_list = "\n".join([f"- {rule['intent']}: {rule['description']}" for rule in self.rules])
        if verbose: print("Classifier initialized successfully. ✅")

    def _load_rules(self, filepath):
        with open(filepath, 'r') as f:
            return json.load(f)

    def _initialize_primary_matcher(self, verbose):
        if verbose: print("- Building Primary Matcher (TF-IDF)...")
        corpus = [" ".join(rule['keywords']) + " " + rule['description'] for rule in self.rules]
        self.primary_intents = [rule['intent'] for rule in self.rules]
        self.tfidf_vectorizer = TfidfVectorizer(stop_words='english', ngram_range=(1, 2)).fit(corpus)
        self.tfidf_rule_vectors = self.tfidf_vectorizer.transform(corpus)

    def _initialize_secondary_matcher(self, verbose):
        if verbose: print("- Building Secondary Matcher (Semantic)...")
        self.semantic_intents = [rule['intent'] for rule in self.rules]
        rule_descriptions = [rule['description'] for rule in self.rules]
        self.semantic_model = SentenceTransformer('all-MiniLM-L6-v2')
        self.semantic_rule_embeddings = self.semantic_model.encode(
            rule_descriptions, convert_to_tensor=True
        )

    def _primary_match(self, user_input):
        input_vector = self.tfidf_vectorizer.transform([user_input])
        similarities = cosine_similarity(input_vector, self.tfidf_rule_vectors)
        best_match_index = np.argmax(similarities)
        confidence = similarities[0, best_match_index]
        intent = self.primary_intents[best_match_index]
        return {"intent": intent, "confidence": confidence}

    def _secondary_match(self, user_input):
        input_embedding = self.semantic_model.encode(user_input, convert_to_tensor=True)
        cosine_scores = util.cos_sim(input_embedding, self.semantic_rule_embeddings)
        best_match_index = torch.argmax(cosine_scores)
        confidence = cosine_scores[0, best_match_index].item()
        intent = self.semantic_intents[best_match_index]
        return {"intent": intent, "confidence": confidence}

    async def _gemini_match(self, user_input):
        """Uses the Gemini API as the final classifier with a stricter prompt."""
        if not self.gemini_model:
            return "NO_API_KEY"

        # <<< FIX: The prompt is now much stricter to prevent conversational responses.
        prompt = f"""
            You are an expert intent classification system. Your entire job is to return a single intent name.

            ## Available Intents:
            {self.gemini_intent_list}

            ## User Message:
            "{user_input}"

            ## Instructions:
            1.  Analyze the user message.
            2.  Your entire response must be ONLY the single, most appropriate intent name from the list above.
            3.  DO NOT add any explanation, conversation, preamble, or markdown formatting.
            4.  If no intent is a clear match, your entire response must be ONLY the text "NO_MATCH".

            ## Example:
            User Message: "show me my urgent tasks"
            Your Response: LIST_HIGH_PRIORITY_TASKS
        """
        try:
            response = await self.gemini_model.generate_content_async(prompt)
            # We add a final check here to find the intent in the response,
            # in case the model still adds minor extra text.
            text_response = response.text.strip()
            for intent in self.semantic_intents: # A list of all possible intents
                if intent in text_response:
                    return intent # Return the first valid intent found
            return "NO_MATCH" # If no valid intent is found in the string, fallback

        except Exception as e:
            print(f"Error calling Gemini API: {e}")
            return "API_ERROR"

    # <<< Added a 'verbose' parameter to control printing
    async def classify(self, user_input, verbose=True):
        primary_result = self._primary_match(user_input)
        if verbose: print(f"  - Primary Matcher (TF-IDF) confidence: {primary_result['confidence']:.4f} for intent '{primary_result['intent']}'")
        if primary_result["confidence"] >= PRIMARY_THRESHOLD:
            return { "intent": primary_result["intent"], "confidence": f"{primary_result['confidence']:.2f}", "matcher": "Primary (TF-IDF)" }

        secondary_result = self._secondary_match(user_input)
        if verbose: print(f"  - Secondary Matcher (Semantic) confidence: {secondary_result['confidence']:.4f} for intent '{secondary_result['intent']}'")
        if secondary_result["confidence"] >= SECONDARY_THRESHOLD:
            return { "intent": secondary_result["intent"], "confidence": f"{secondary_result['confidence']:.2f}", "matcher": "Secondary (Semantic)" }
        
        if verbose: print("  - Escalating to Gemini Fallback...")
        gemini_intent = await self._gemini_match(user_input)
        if gemini_intent not in ["NO_MATCH", "API_ERROR", "NO_API_KEY"]:
            return { "intent": gemini_intent, "confidence": "N/A", "matcher": "Fallback (Gemini)" }

        return { "intent": "FALLBACK", "confidence": "0.00", "matcher": None, "message": "Could not create a response. Please try rephrasing." }

# <<< This is the main test function for running directly
async def run_tests():
    try:
        classifier = IntentClassifier(rules_filepath="rules.json")
    except FileNotFoundError:
        print("\nERROR: `rules.json` not found. Please create it before running.")
        return

    print("\n--- Testing Full Pipeline with Gemini Fallback ---")
    
    test_queries = [ "count my tasks", "what are my most important tasks?", "who is the user jane_doe", "what's the capital of South Korea?" ]

    for query in test_queries:
        print(f"\nQuery: '{query}'")
        result = await classifier.classify(query)
        print(f"--> Result: {result}")

# <<< This is the entry point for being called from Node.js
async def process_query(query):
    # Initialize the classifier in non-verbose mode
    classifier = IntentClassifier(rules_filepath="rules.json", verbose=False)
    # Classify the query in non-verbose mode
    result = await classifier.classify(query, verbose=False)
    # Print ONLY the final JSON result
    print(json.dumps(result))

# <<< Main execution block now checks for command-line arguments
if __name__ == "__main__":
    # If arguments are passed (like from Node.js), process the query.
    if len(sys.argv) > 1:
        user_query = sys.argv[1]
        asyncio.run(process_query(user_query))
    # If run directly, run the tests.
    else:
        asyncio.run(run_tests())