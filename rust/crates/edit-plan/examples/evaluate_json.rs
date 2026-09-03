use edit_plan::{EditPlanEvaluationResponse, EvaluateEditPlanOptions, evaluate_edit_plan};
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let requests: Vec<EvaluateEditPlanOptions> = serde_json::from_str(&input)?;
    let responses: Vec<EditPlanEvaluationResponse> =
        requests.into_iter().map(evaluate_edit_plan).collect();
    serde_json::to_writer(io::stdout().lock(), &responses)?;
    Ok(())
}
