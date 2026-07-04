-- ⚠️ Create the feedback table with foreign key linkage and rating constraint guards
CREATE TABLE feedbacks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    feedback_type VARCHAR(50) NOT NULL CHECK (feedback_type IN ('Feature', 'Bug', 'Design', 'Other')),
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Optimize queries searching historical feedback records
CREATE INDEX idx_feedbacks_profile_id ON feedbacks(profile_id);