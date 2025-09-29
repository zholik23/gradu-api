import base64
import json
import os
import re
import pandas as pd
from openai import OpenAI
from rapidfuzz import process, fuzz
import sys

# --- ROBUST PATH FIX: Determine paths relative to this script's location ---
script_dir = os.path.dirname(os.path.abspath(__file__))
csv_path = os.path.join(script_dir, "medicines.csv")

# Log the arguments received from Node.js for debugging
print(f"[Python] Received arguments: {sys.argv}", file=sys.stderr)

# ====== Load Medicine Dictionary ======
try:
    med_dict = pd.read_csv(csv_path)
    if 'id' not in med_dict.columns:
        raise ValueError("The 'medicines.csv' file must contain an 'id' column.")
except Exception as e:
    error_msg = {"error": f"Failed to load medicines.csv: {e}"}
    print(json.dumps(error_msg), file=sys.stderr)
    sys.exit(1)

# ====== Upstage Client ======
client = OpenAI(
    api_key="up_0xiZGIC9T6of93SeqWgJjTpirVr2n", # Consider using environment variables
    base_url="https://api.upstage.ai/v1/information-extraction"
)

# ====== Image Encoding & OCR ======
def extract_prescription(filepath: str):
    base64_data = encode_img_to_base64(filepath)
    if not base64_data: return {"medications": []}
    try:
        extraction_response = client.chat.completions.create(
            model="information-extract",
            messages=[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": f"data:application/octet-stream;base64,{base64_data}"}}]}],
            response_format={"type": "json_schema", "json_schema": {"name": "extraction_schema", "schema": {"type": "object", "properties": {"patient": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}},"required": ["name"]}}, "medications": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "dosage": {"type": "number"}, "frequency": {"type": "integer"}, "duration": {"type": "integer"}, "instructions": {"type": "string"}}, "required": ["name", "dosage", "frequency", "duration", "instructions"]}}}}}}
        )
        content_str = extraction_response.choices[0].message.content
        data = json.loads(content_str)
        print("\n[Python] Raw AI Extraction:", json.dumps(data, indent=2, ensure_ascii=False), file=sys.stderr)
        return data
    except Exception as e:
        error_msg = {"error": f"An error occurred during API extraction: {str(e)}"}
        print(json.dumps(error_msg), file=sys.stderr)
        return {"medications": []}

def encode_img_to_base64(img_path):
    try:
        with open(img_path, 'rb') as img_file:
            return base64.b64encode(img_file.read()).decode('utf-8')
    except FileNotFoundError:
        return None

# ====== Smarter Fuzzy Matching with ID retrieval ======
def normalize_med_name(ocr_name: str, med_dict_df: pd.DataFrame):
    if med_dict_df.empty or not ocr_name:
        return {"name": ocr_name, "id": -1}

    cleaned_name = re.sub(r'\s*\d+(\.\d+)?\s*(mg|mL|g|IU)|\s*\(P/PP\)|\s*\(\d+\)', '', ocr_name, flags=re.IGNORECASE).strip()

    name_kr_list = med_dict_df["NameKr"].dropna().tolist()
    result = process.extractOne(cleaned_name, name_kr_list, scorer=fuzz.WRatio, score_cutoff=75)
    
    if result:
        match, score, index = result
        row = med_dict_df.loc[med_dict_df["NameKr"] == match].iloc[0]
        return {"name": match, "id": int(row["id"])}

    return {"name": cleaned_name, "id": -1}

# ====== Smarter Instruction Parsing (no changes needed here) ======
def parse_instruction(instruction_text: str):
    time_pattern = re.compile(r'(\d{1,2})\s*(?:시|:|am|pm)', re.IGNORECASE)
    found_times = time_pattern.findall(instruction_text)
    if found_times:
        strict_times = []
        for time_str in found_times:
            hour = int(time_str)
            if 'pm' in instruction_text.lower() and 1 <= hour < 12: hour += 12
            elif 'am' in instruction_text.lower() and hour == 12: hour = 0
            strict_times.append(f"{hour:02d}:00:00")
        if strict_times:
            return {"scheduleType": "nTimes", "isNTimesStrict": True, "nTimesCount": len(strict_times), "strictTimes": sorted(list(set(strict_times)))}

    meal_keywords = {"아침": "breakfast", "점심": "lunch", "저녁": "dinner"}
    relation_keywords = {"식후": "after", "식전": "before"}
    relation, meals = None, []
    for keyword, value in relation_keywords.items():
        if keyword in instruction_text: relation = value; break
    for keyword, value in meal_keywords.items():
        if keyword in instruction_text: meals.append(value)
    if meals or relation or "식사" in instruction_text:
        if not meals and "식사" in instruction_text: meals = ["breakfast", "lunch", "dinner"]
        if meals and not relation: relation = "after"
        return {"scheduleType": "mealBased", "mealRelation": relation, "selectedMeals": sorted(list(set(meals)))}
    
    return { "scheduleType": "once" }

# ====== Main Parsing Function ======
def prescription_pipeline(image_path: str, med_dict_df: pd.DataFrame) -> dict:
    if not os.path.exists(image_path):
        return {"error": f"Image file not found at path: {image_path}"}
    
    extracted_data = extract_prescription(image_path)
    medications = extracted_data.get("medications")
    
    if not medications:
        return {"error": "Failed to extract any medications from the image."}
         
    parsed_tasks = []
    for med in medications:
        ocr_name = med.get("name") or "Unknown Medication"
        
        normalized_info = normalize_med_name(ocr_name, med_dict_df)
        instruction_details = parse_instruction(med.get("instructions", ""))
        
        task_state = {
            "isMedication": True,
            "medicationName": normalized_info["name"],
            "medicationId": normalized_info["id"],
            "description": f"Dosage: {med.get('dosage')}, Instructions: {med.get('instructions', 'N/A')}",
            "startDate": pd.Timestamp.now().strftime('%Y-%m-%d'),
            "duration": str(med.get("duration", "")),
            **instruction_details 
        }
        parsed_tasks.append(task_state)

    return {"success": True, "tasks": parsed_tasks}

# ====== Main Execution Block ======
if __name__ == "__main__":
    if len(sys.argv) > 1:
        image_path = sys.argv[1]
        final_output = prescription_pipeline(image_path, med_dict)
        
        print("\n[Python] Final JSON Output:", file=sys.stderr)
        print(json.dumps(final_output, indent=2, ensure_ascii=False), file=sys.stderr)

        if final_output.get("error"):
            print(json.dumps({"success": False, "error": final_output["error"]}), file=sys.stderr)
            sys.exit(1)
        else:
            json_output_string = json.dumps(final_output, ensure_ascii=False)
            sys.stdout.buffer.write(json_output_string.encode('utf-8'))
    else:
        error_msg = {"success": False, "error": "No image path provided to Python script."}
        print(json.dumps(error_msg), file=sys.stderr)
        sys.exit(1)

